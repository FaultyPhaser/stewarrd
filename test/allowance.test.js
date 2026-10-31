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
const { checkBalances } = await import('../src/services/integrity.js');

const movie = { seerrId: 70, tmdbId: 700, tvdbId: null, mediaType: 'movie', title: 'Movie' };

test('users follow the global default until an override is set', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  assert.equal(credits.allowanceFor(2), 10);
  assert.equal(credits.allowanceOverride(2), null);
  assert.equal(credits.getBalance(2), 10);
});

test('setting an override moves the balance immediately and the integrity check agrees', () => {
  credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 1, media: movie }); // balance 9
  const r = credits.setAllowance(2, 15, 1);
  assert.deepEqual([r.before, r.after, r.balance], [10, 15, 14]);
  assert.equal(credits.allowanceFor(2), 15);
  assert.deepEqual(checkBalances('a1').fixes, []);

  const entry = db.prepare(`SELECT * FROM integrity_log WHERE kind = 'ALLOWANCE_CHANGED' AND user_id = 2`).get();
  assert.equal(entry.before_value, '10');
  assert.equal(entry.after_value, '15');
});

test('lowering the override can overdraw, and clearing returns to the default', () => {
  assert.equal(credits.setAllowance(2, 0, 1).balance, -1);
  assert.deepEqual(checkBalances('a2').fixes, []);
  const r = credits.setAllowance(2, null, 1);
  assert.deepEqual([r.before, r.after, r.balance], [0, 10, 9]);
  assert.equal(credits.allowanceOverride(2), null);
  assert.deepEqual(checkBalances('a3').fixes, []);
});

test('a new user with a pre-set override starts from it; other users are unaffected', () => {
  db.prepare('INSERT INTO users (seerr_user_id, username, request_credits, credit_allowance) VALUES (5, ?, 4, 4)').run('pre');
  assert.equal(credits.allowanceFor(5), 4);
  credits.upsertUser({ id: 5, username: 'pre2' }); // upsert must keep the override
  assert.equal(credits.allowanceOverride(5), 4);
  assert.equal(credits.allowanceFor(2), 10);
});

test('invalid input, the admin and unknown users are rejected', () => {
  assert.throws(() => credits.setAllowance(2, -1), { status: 400 });
  assert.throws(() => credits.setAllowance(2, 1.5), { status: 400 });
  assert.throws(() => credits.setAllowance(1, 5), { status: 400 });
  assert.throws(() => credits.setAllowance(999, 5), { status: 404 });
  assert.equal(credits.getBalance(2), 9);
});
