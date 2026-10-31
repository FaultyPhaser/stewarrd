import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-hold-'));
process.env.SEERR_URL = 'http://localhost:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '5';
process.env.CREDIT_COST_MOVIE = '1';
process.env.MIN_STEWARDSHIP_DAYS = '30';

const { db } = await import('../src/db.js');
const credits = await import('../src/services/credits.js');
const { applyFlag, applySave, removeUnit } = await import('../src/services/transfers.js');
const { assignUnit } = await import('../src/services/assign.js');
const settings = await import('../src/services/settings.js');

let n = 100;
function request(userId, title = `Movie ${n}`) {
  n += 1;
  credits.chargeForRequest({
    requestId: n,
    requesterId: userId,
    unitCost: 1,
    media: { seerrId: n, tmdbId: n, tvdbId: null, mediaType: 'movie', title },
  });
  return credits.findUnit(`movie:${n}`).unit_id;
}
const backdate = (unitId, days) => db.prepare(`UPDATE media_flags SET held_since = datetime('now', ?) WHERE unit_id = ?`).run(`-${days} days`, unitId);

credits.upsertUser({ id: 2, username: 'alice' });
credits.upsertUser({ id: 3, username: 'bob' });

test('the default is 30 days and a release is blocked until the owner has held the item that long', () => {
  assert.equal(settings.getMinStewardshipDays(), 30);
  const u = request(2);
  assert.throws(() => applyFlag(u, 2), (e) => e.status === 409 && /Minimum stewardship: 30 day/.test(e.message) && e.remainingDays === 30);
  backdate(u, 29);
  assert.throws(() => applyFlag(u, 2), /1 day\(s\) remaining/);
  backdate(u, 30);
  assert.equal(applyFlag(u, 2).status, 'FLAGGED_FOR_REMOVAL');
});

test('the admin changes the minimum at runtime; 0 turns it off; bad values are rejected', () => {
  const u = request(2);
  settings.updateSettings({ minStewardshipDays: 0 });
  assert.equal(applyFlag(u, 2).status, 'FLAGGED_FOR_REMOVAL');
  settings.updateSettings({ minStewardshipDays: 10 });
  const v = request(2);
  backdate(v, 9);
  assert.throws(() => applyFlag(v, 2), /1 day\(s\) remaining/);
  for (const bad of [-1, 1.5, '5', 4000, null]) {
    assert.throws(() => settings.updateSettings({ minStewardshipDays: bad }), /whole number/, String(bad));
  }
  assert.throws(() => settings.updateSettings({ applyToClaims: 'yes' }), /true or false/);
  settings.updateSettings({ minStewardshipDays: 30 });
});

test('a claim starts a new hold, unless "apply to claimed items" is off', () => {
  const u = request(2);
  backdate(u, 60);
  applyFlag(u, 2);

  applySave(u, 3); // bob claims it
  assert.ok(credits.getUnit(u).held_since);
  assert.throws(() => applyFlag(u, 3), /Minimum stewardship/);

  backdate(u, 60);
  applyFlag(u, 3);
  settings.updateSettings({ applyToClaims: false });
  applySave(u, 3);
  assert.equal(credits.getUnit(u).held_since, null);
  assert.equal(applyFlag(u, 3).status, 'FLAGGED_FOR_REMOVAL'); // released straight away
  settings.updateSettings({ applyToClaims: true });
});

test('the admin is exempt, and an admin assignment or buyout leaves no hold', () => {
  const own = request(1); // admin request: no hold, and the admin is never held anyway
  assert.equal(credits.getUnit(own).held_since, null);
  assert.equal(applyFlag(own, 1).status, 'FLAGGED_FOR_REMOVAL');

  const u = request(2);
  assert.ok(credits.getUnit(u).held_since);
  assignUnit(u, 3, { charge: true });
  assert.equal(credits.getUnit(u).held_since, null);
  assert.equal(applyFlag(u, 3).status, 'FLAGGED_FOR_REMOVAL');

  const w = request(2);
  applySave(w, 1); // admin buyout of an active item
  assert.equal(credits.getUnit(w).held_since, null);
});

test('items that existed before the feature (no hold date) can be released', () => {
  const u = request(2);
  db.prepare('UPDATE media_flags SET held_since = NULL WHERE unit_id = ?').run(u);
  assert.equal(applyFlag(u, 2).status, 'FLAGGED_FOR_REMOVAL');
});

test('deleting an active item refunds what the owner paid, regardless of the hold', () => {
  const before = credits.getBalance(2);
  const u = request(2);
  assert.equal(credits.getBalance(2), before - 1);
  assert.equal(removeUnit(u), 1);
  assert.equal(credits.getBalance(2), before);
  assert.equal(credits.getUnit(u), undefined);
});

test('deleting refunds a claimer what they paid, and never twice for a released item', () => {
  const u = request(2);
  backdate(u, 60);
  applyFlag(u, 2); // alice released: refunded then
  const bobBefore = credits.getBalance(3);
  applySave(u, 3); // bob pays 1
  assert.equal(credits.getBalance(3), bobBefore - 1);
  assert.equal(removeUnit(u), 1);
  assert.equal(credits.getBalance(3), bobBefore);

  const v = request(2);
  backdate(v, 60);
  applyFlag(v, 2);
  const aliceBefore = credits.getBalance(2);
  assert.equal(removeUnit(v), 0); // already refunded at release
  assert.equal(credits.getBalance(2), aliceBefore);
});

test('deleting an assigned item refunds the new owner what they were charged', () => {
  const u = request(2);
  assignUnit(u, 3, { charge: true });
  const bobBefore = credits.getBalance(3);
  assert.equal(removeUnit(u), 1);
  assert.equal(credits.getBalance(3), bobBefore + 1);
});

test('deleting an admin-owned item refunds nothing', () => {
  const u = request(1);
  assert.equal(removeUnit(u), 0);
});
