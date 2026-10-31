import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Mock Seerr: records every write and serves media info with the requests it currently holds.
const calls = [];
const requests = [];
const seasonStatus = {}; // tmdb id -> { seasonNumber: Seerr media status }
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (req.method !== 'GET') calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const m = /^\/api\/v1\/(movie|tv)\/(\d+)$/.exec(req.url);
    if (req.method === 'GET' && m) return send(200, { mediaInfo: { status: 5, seasons: Object.entries(seasonStatus[m[2]] ?? {}).map(([n, status]) => ({ seasonNumber: Number(n), status })), requests: requests.filter((r) => r.tmdb === Number(m[2])) } });
    if (req.method === 'GET' && req.url.startsWith('/api/v1/request?')) return send(200, { results: requests });
    const d = /^\/api\/v1\/request\/(\d+)$/.exec(req.url);
    if (req.method === 'DELETE' && d) { requests.splice(requests.findIndex((r) => r.id === Number(d[1])), 1); return send(204); }
    if (req.method === 'POST' && req.url === '/api/v1/request') {
      const b = JSON.parse(body);
      const r = { id: 500 + requests.length, tmdb: b.mediaId, is4k: false, requestedBy: { id: b.userId }, seasons: (Array.isArray(b.seasons) ? b.seasons : []).map((n) => ({ seasonNumber: n })) };
      requests.push(r);
      return send(201, { id: r.id });
    }
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
process.env.SEERR_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.ADMIN_RUN = '1';
process.env.DEFAULT_CREDITS = '10';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '3';

const credits = await import('../src/services/credits.js');
const { applyFlag, applySave, removeUnit } = await import('../src/services/transfers.js');
const { removeRequestsInSeerr, claimInSeerr, removeFilledRequests } = await import('../src/services/seerrSync.js');

test.after(() => server.close());

/** Mirrors the admin purge: remember the rows, delete them locally, then clean up Seerr. */
const purge = (...units) => {
  const gone = units.map((u) => credits.getUnit(u.unit_id));
  units.forEach((u) => removeUnit(u.unit_id));
  return removeRequestsInSeerr(gone);
};

test('releasing keeps the Seerr request; claim creates one for the adopter', async () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });
  credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 1, media: { seerrId: 10, tmdbId: 100, tvdbId: null, mediaType: 'movie', title: 'M' } });
  requests.push({ id: 7, tmdb: 100, is4k: false, requestedBy: { id: 2 }, seasons: [] });

  const unit = credits.findUnit('movie:100');
  applyFlag(unit.unit_id, 2);
  assert.equal(calls.length, 0); // release never touches Seerr
  assert.ok(requests.some((r) => r.id === 7));

  const adopted = applySave(unit.unit_id, 3);
  const claim = await claimInSeerr(adopted, 3);
  assert.equal(claim.action, 'created');
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { mediaType: 'movie', mediaId: 100, userId: 3, ignoreQuota: true });
  assert.equal(requests.at(-1).requestedBy.id, 3);

  // claiming again does not create a duplicate
  assert.equal((await claimInSeerr(adopted, 3)).action, 'exists');
});

test('purging a movie removes its Seerr request', async () => {
  calls.length = 0;
  credits.chargeForRequest({ requestId: 5, requesterId: 2, unitCost: 1, media: { seerrId: 30, tmdbId: 300, tvdbId: null, mediaType: 'movie', title: 'P' } });
  requests.push({ id: 11, tmdb: 300, is4k: false, requestedBy: { id: 2 }, seasons: [] });

  const unit = credits.findUnit('movie:300');
  applyFlag(unit.unit_id, 2);
  assert.equal(calls.length, 0);

  const out = await purge(unit);
  assert.equal(out.action, 'removed');
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), ['/api/v1/request/11']);
});

test('purging a season of a filled request just deletes it', async () => {
  calls.length = 0;
  credits.chargeForRequest({ requestId: 2, requesterId: 2, unitCost: 3, media: { seerrId: 20, tmdbId: 200, tvdbId: 2000, mediaType: 'tv', title: 'S' }, seasons: [1, 2] });
  requests.push({ id: 9, tmdb: 200, is4k: false, status: 5, requestedBy: { id: 2 }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] });
  seasonStatus[200] = { 1: 5, 2: 5 };

  const s1 = credits.findUnit('tv:2000', 1);
  applyFlag(s1.unit_id, 2);
  const out = await purge(s1);
  assert.equal(out.action, 'removed');
  assert.deepEqual(out.recreated, []);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['DELETE /api/v1/request/9']);
});

test('a request with unfilled seasons is recreated for the same user without the purged season', async () => {
  calls.length = 0;
  credits.chargeForRequest({ requestId: 3, requesterId: 3, unitCost: 3, media: { seerrId: 40, tmdbId: 400, tvdbId: 4000, mediaType: 'tv', title: 'T' }, seasons: [1, 2, 3] });
  requests.push({ id: 20, tmdb: 400, is4k: false, status: 2, requestedBy: { id: 3 }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }] });
  seasonStatus[400] = { 1: 5, 2: 5, 3: 3 };

  const s1 = credits.findUnit('tv:4000', 1);
  applyFlag(s1.unit_id, 3);
  const gone = [credits.getUnit(s1.unit_id)];

  const preview = await removeRequestsInSeerr(gone, { dryRun: true });
  assert.equal(preview.action, 'dry_run');
  assert.deepEqual(preview.plan, [{ requestId: 20, userId: 3, keep: [3] }]);
  assert.equal(calls.length, 0); // a dry run writes nothing

  removeUnit(s1.unit_id);
  const out = await removeRequestsInSeerr(gone);
  assert.equal(out.action, 'removed');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['DELETE /api/v1/request/20', 'POST /api/v1/request']);
  assert.deepEqual(calls[1].body, { mediaType: 'tv', mediaId: 400, userId: 3, seasons: [3], ignoreQuota: true, tvdbId: 4000 });
  assert.deepEqual(out.recreated.map((r) => r.seasons), [[3]]);
});

test('declined and failed requests are left alone', async () => {
  calls.length = 0;
  credits.chargeForRequest({ requestId: 4, requesterId: 2, unitCost: 1, media: { seerrId: 50, tmdbId: 500, tvdbId: null, mediaType: 'movie', title: 'D' } });
  requests.push({ id: 30, tmdb: 500, is4k: false, status: 3, requestedBy: { id: 2 }, seasons: [] });
  const unit = credits.findUnit('movie:500');
  applyFlag(unit.unit_id, 2);
  assert.equal((await purge(unit)).action, 'none');
  assert.equal(calls.length, 0);
});

test('the cleanup deletes only filled, non-4K requests and supports a dry run', async () => {
  calls.length = 0;
  requests.push(
    { id: 801, tmdb: 8001, is4k: false, status: 5, requestedBy: { id: 2 }, seasons: [] }, // filled: deleted
    { id: 802, tmdb: 8002, is4k: false, status: 2, requestedBy: { id: 2 }, seasons: [] }, // approved, still open
    { id: 803, tmdb: 8003, is4k: true, status: 5, requestedBy: { id: 2 }, seasons: [] }, // 4K: left alone
    { id: 804, tmdb: 8004, is4k: false, status: 3, requestedBy: { id: 2 }, seasons: [] }, // declined: left alone
  );

  const dry = await removeFilledRequests({ dryRun: true });
  assert.equal(dry.action, 'dry_run');
  assert.deepEqual(dry.removed, [801]);
  assert.equal(calls.length, 0);

  const out = await removeFilledRequests();
  assert.deepEqual(out.removed, [801]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['DELETE /api/v1/request/801']);
  assert.deepEqual(requests.filter((r) => r.id >= 801).map((r) => r.id), [802, 803, 804]);
});
