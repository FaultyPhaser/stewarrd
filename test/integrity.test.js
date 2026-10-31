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
const { applyFlag, applySave } = await import('../src/services/transfers.js');
const { checkBalances, checkOrphans, runIntegrityCheck, recentLog } = await import('../src/services/integrity.js');

const show = { seerrId: 60, tmdbId: 600, tvdbId: 6000, mediaType: 'tv', title: 'Show' };
const movie = { seerrId: 61, tmdbId: 601, tvdbId: null, mediaType: 'movie', title: 'Movie' };
const setBalance = (id, n) => db.prepare('UPDATE users SET request_credits = ? WHERE seerr_user_id = ?').run(n, id);

test('balances follow allowance + ledger across every kind of transaction, so a healthy db needs no fixes', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });
  credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 3, media: show, seasons: [1, 2] }); // -6
  credits.chargeForRequest({ requestId: 2, requesterId: 2, unitCost: 1, media: movie, available: false }); // -1
  applyFlag(credits.findUnit('tv:6000', 1).unit_id, 2); // +3
  applySave(credits.findUnit('tv:6000', 1).unit_id, 3); // b -3
  applyFlag(credits.findUnit('movie:601').unit_id, 2); // +1 (not downloaded, released like any other)
  credits.chargeForRequest({ requestId: 3, requesterId: 3, unitCost: 1, media: { ...movie, seerrId: 62, tmdbId: 602 } });
  credits.refundRequest(3);
  const r = checkBalances('t0');
  assert.deepEqual(r.fixes, []);
  assert.equal(credits.getBalance(2), 10 - 6 - 1 + 3 + 1);
  assert.equal(credits.getBalance(3), 10 - 3);
});

test('a wrong balance is corrected from the ledger and logged; admin is untouched', () => {
  setBalance(2, 999);
  setBalance(1, 12345);
  const r = checkBalances('t1');
  assert.equal(r.fixes.length, 1);
  assert.deepEqual([r.fixes[0].before, r.fixes[0].after], [999, 7]);
  assert.equal(credits.getBalance(2), 7);
  assert.equal(db.prepare('SELECT request_credits AS n FROM users WHERE seerr_user_id = 1').get().n, 12345);

  const entry = recentLog().find((e) => e.runId === 't1');
  assert.equal(entry.kind, 'BALANCE_CORRECTED');
  assert.equal(entry.before, '999');
  assert.equal(entry.after, '7');
  assert.equal(checkBalances('t2').fixes.length, 0); // idempotent
});

test('a user with no ledger history is expected to hold the allowance', () => {
  credits.upsertUser({ id: 4, username: 'c' });
  setBalance(4, 2);
  const r = checkBalances('t3');
  assert.equal(r.fixes[0].after, 10);
});

test('orphans are reported but not changed; full run is safe when Seerr is down', async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare('INSERT INTO credit_ledger_logs (media_id, unit_id, from_user_id, amount, reason) VALUES (1, 99999, NULL, 0, ?)').run('x');
  db.pragma('foreign_keys = ON');
  assert.equal(checkOrphans('t4').orphanLedger, 1);

  const before = credits.getBalance(2);
  const result = await runIntegrityCheck({ trigger: 'test' });
  assert.equal(result.balances.fixes.length, 0);
  assert.equal(credits.getBalance(2), before);
  assert.ok(result.reconcile.skipped); // Seerr is down: nothing is reconciled or deleted
  assert.equal(result.seerr.action, 'skipped');
});
