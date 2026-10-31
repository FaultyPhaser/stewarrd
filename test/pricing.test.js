import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-pricing-'));
process.env.SEERR_URL = 'http://localhost:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '10';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '3';
process.env.MIN_STEWARDSHIP_DAYS = '0';

const credits = await import('../src/services/credits.js');
const settings = await import('../src/services/settings.js');
const { applyFlag, applySave } = await import('../src/services/transfers.js');
const { checkBalances, checkPricing, recentLog } = await import('../src/services/integrity.js');

let n = 700;
function request(userId, mediaType, seasons) {
  n += 1;
  credits.chargeForRequest({
    requestId: n,
    requesterId: userId,
    unitCost: credits.requestUnitCost(mediaType, userId),
    media: { seerrId: n, tmdbId: n, tvdbId: mediaType === 'tv' ? n : null, mediaType, title: `Title ${n}` },
    seasons,
  });
  return credits.findUnit(mediaType === 'movie' ? `movie:${n}` : `tv:${n}`, mediaType === 'movie' ? null : seasons[0]).unit_id;
}
const fix = (run) => { const p = checkPricing(run); checkBalances(run); return p; };

credits.upsertUser({ id: 2, username: 'alice' });
credits.upsertUser({ id: 3, username: 'bob' });

test('request, release and claim all move the season cost (zero-sum)', () => {
  const s = request(2, 'tv', [1]);
  assert.equal(credits.getBalance(2), 7);
  applyFlag(s, 2);
  assert.equal(credits.getBalance(2), 10); // full refund
  applySave(s, 3);
  assert.equal(credits.getBalance(3), 7); // claim costs the same as a request
  assert.equal(fix('z').fixes.length, 0); // nothing to correct
});

test('a claim is refused when the balance does not cover the cost', () => {
  credits.setAllowance(2, 2, 1);
  checkBalances('a');
  const s = request(3, 'tv', [1]);
  applyFlag(s, 3);
  assert.throws(() => applySave(s, 2), /Not enough credits/);
  credits.setAllowance(2, null, 1);
  checkBalances('a2');
});

test('old fixed 1-credit releases and claims are corrected to the current cost', () => {
  const s = request(2, 'tv', [1]); // alice -3
  const before2 = credits.getBalance(2);
  const before3 = credits.getBalance(3);
  // simulate the old code: release +1, claim -1
  applyFlag(s, 2);
  credits.recordLedger(s, 2, null, 2, 'legacy-test'); // undo 2 of the 3 refunded, so alice net +1
  credits.credit(2, -2);
  applySave(s, 3);
  credits.recordLedger(s, null, 3, 2, 'legacy-test'); // bob only paid 1
  credits.credit(3, 2);
  assert.equal(credits.getBalance(2), before2 + 1);
  assert.equal(credits.getBalance(3), before3 - 1);

  const p = checkPricing('dry', { dryRun: true });
  assert.equal(p.fixes.length, 2);
  assert.equal(credits.getBalance(2), before2 + 1); // dry run writes nothing

  const r = fix('legacy');
  assert.equal(r.fixes.length, 2);
  assert.equal(credits.getBalance(2), before2 + 3); // alice gets the rest of her refund
  assert.equal(credits.getBalance(3), before3 - 3); // bob pays the full cost
  assert.ok(recentLog().some((e) => e.runId === 'legacy' && e.kind === 'PRICE_CORRECTED'));
  assert.equal(fix('again').fixes.length, 0); // idempotent
});

test('a cost change re-prices requested and claimed units; released units stay at 0; admin untouched', () => {
  const owned = request(2, 'movie');
  const released = request(3, 'movie');
  applyFlag(released, 3);
  request(1, 'movie');
  const a = credits.getBalance(2);
  const b = credits.getBalance(3); // bob owns 1 claimed season + 1 requested season
  settings.updateSettings({ costMovie: 4, costTvSeason: 5 });
  fix('cost');
  assert.equal(credits.getBalance(2), a - 3); // movie 1 -> 4
  assert.equal(credits.getBalance(3), b - 2 - 2); // two seasons 3 -> 5, released movie unchanged
  assert.equal(credits.getBalance(1), null);
  assert.equal(credits.getUnit(owned).current_owner_id, 2);
});
