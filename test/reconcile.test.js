import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// One mock server stands in for Seerr, Radarr and Sonarr.
const state = { media: [], requests: [], users: [], movies: [], series: [], writes: 0, fail: false };
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') state.writes += 1;
  if (state.fail) { res.writeHead(500); return res.end('{}'); }
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url.startsWith('/api/v1/media')) return send({ results: state.media });
  if (req.url.startsWith('/api/v1/request')) return send({ results: state.requests });
  if (req.url.startsWith('/api/v1/user')) return send({ results: state.users });
  if (/^\/api\/v1\/(movie|tv)\//.test(req.url)) return send({ title: 'Fetched Title' });
  if (req.url.startsWith('/api/v3/movie')) return send(state.movies);
  if (req.url.startsWith('/api/v3/series')) return send(state.series);
  res.writeHead(404);
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
for (const k of ['SEERR', 'RADARR', 'SONARR']) { process.env[`${k}_URL`] = base; process.env[`${k}_API_KEY`] = 'x'; }
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '10';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '3';

const { db } = await import('../src/db.js');
const credits = await import('../src/services/credits.js');
const { reconcileWithArr } = await import('../src/services/reconcile.js');

test.after(() => server.close());

const units = () => db.prepare('SELECT * FROM media_flags ORDER BY seerr_id, season_number').all();
const find = (mediaId, season = null) => units().find((u) => u.seerr_id === mediaId && u.season_number === season);

test('reconcile: *arr decides what exists, open Seerr requests are added, deleted seasons stay gone', async () => {
  credits.upsertUser({ id: 1, username: 'admin' });
  credits.upsertUser({ id: 2, username: 'alice' });
  credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 1, media: { seerrId: 10, tmdbId: 100, tvdbId: null, mediaType: 'movie', title: 'Gone' } });
  credits.chargeForRequest({ requestId: 2, requesterId: 2, unitCost: 1, available: false, media: { seerrId: 11, tmdbId: 101, tvdbId: null, mediaType: 'movie', title: 'Waiting' } });

  state.users = [{ id: 1, username: 'admin' }, { id: 2, username: 'alice' }, { id: 3, username: 'bob', email: 'b@x' }];
  state.media = [
    { id: 11, mediaType: 'movie', tmdbId: 101, status: 3 }, // tracked, still waiting for files
    { id: 12, mediaType: 'movie', tmdbId: 102, status: 5 }, // in Radarr, not tracked
    { id: 13, mediaType: 'movie', tmdbId: 103, status: 3 }, // approved request by bob, not in Radarr yet
    { id: 14, mediaType: 'tv', tmdbId: 104, tvdbId: 1040, status: 4, seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 5 }] },
  ];
  state.requests = [
    { id: 50, status: 2, is4k: false, requestedBy: { id: 3, username: 'bob' }, media: { id: 13, mediaType: 'movie', tmdbId: 103 } },
    { id: 52, status: 2, is4k: false, requestedBy: { id: 2 }, media: { id: 11, mediaType: 'movie', tmdbId: 101 } },
    { id: 51, status: 3, is4k: false, requestedBy: { id: 3 }, media: { id: 12, mediaType: 'movie', tmdbId: 102 } }, // declined: ignored
  ];
  state.movies = [{ tmdbId: 102, title: 'In Radarr', hasFile: true }]; // 100 is gone; 101 is not downloaded yet
  state.series = [{ tvdbId: 1040, tmdbId: 104, title: 'Show', seasons: [
    { seasonNumber: 1, monitored: true },
    { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 0 } }, // season 2 was deleted
  ] }];

  const aliceBefore = credits.getBalance(2);
  const dry = await reconcileWithArr({ dryRun: true });
  assert.deepEqual([dry.added, dry.removed], [3, 1]); // movies 12 and 13, show season 1; movie 10 removed
  assert.equal(state.writes, 0);
  assert.deepEqual(dry.plan.remove.map((i) => i.reason), ['no longer in Radarr']);
  assert.ok(dry.plan.add.every((i) => i.owner && i.reason));
  assert.ok(dry.plan.add.some((i) => i.cost > 0 && i.owner !== 'admin')); // an open request would be charged to its requester
  assert.ok(find(10)); // a dry run changes nothing
  assert.equal(find(12), undefined);

  const r = await reconcileWithArr({ runId: 'r1' });
  assert.deepEqual([r.added, r.removed], [3, 1]);
  assert.equal(find(10), undefined); // gone from Radarr -> removed
  assert.ok(find(11)); // not in Radarr but an open request -> kept
  assert.equal(find(12).current_owner_id, 1); // in Radarr only -> admin
  assert.equal(find(12).available, 1);
  assert.equal(find(13).current_owner_id, 3); // open request -> its requester
  assert.equal(find(13).available, 0);
  assert.equal(credits.getBalance(3), 9); // charged like a request
  assert.equal(find(14, 1).current_owner_id, 1);
  assert.equal(find(14, 2), undefined); // the deleted season is not resurrected
  assert.equal(credits.getBalance(2), aliceBefore + 1); // her deleted movie was refunded what she paid

  const again = await reconcileWithArr({ runId: 'r2' });
  assert.deepEqual([again.added, again.removed, again.updated], [0, 0, 0]); // idempotent
  assert.equal(credits.getBalance(3), 9);
});

test('reconcile: a not-downloaded unit is marked downloaded once Seerr reports files', async () => {
  state.movies.push({ tmdbId: 101, title: 'Waiting', hasFile: true });
  state.media = state.media.map((m) => (m.id === 11 ? { ...m, status: 5 } : m));
  const r = await reconcileWithArr({ runId: 'r3' });
  assert.equal(r.updated, 1);
  assert.equal(find(11).available, 1);
});

test('reconcile: an empty Radarr answer never wipes the library', async () => {
  const saved = state.movies;
  state.movies = [];
  const before = units().length;
  const r = await reconcileWithArr({ runId: 'r4' });
  state.movies = saved;
  assert.equal(r.removed, 0);
  assert.equal(r.blocked[0].type, 'movie');
  assert.equal(units().length, before);
});

test('reconcile: if a service cannot be read, nothing changes', async () => {
  state.movies = [];
  state.fail = true;
  const before = units().length;
  const r = await reconcileWithArr({ runId: 'r5' });
  state.fail = false;
  assert.ok(r.skipped);
  assert.equal(units().length, before);
});

test('reconcile: a partly tracked show is completed, not removed, even when the ids do not line up', async () => {
  // Tracked with no TVDB id; Sonarr has no TMDB id; Seerr has no TVDB id. Only the title ties them together.
  for (const s of [1, 2, 3, 4]) {
    credits.addUnit({ seerrId: 20, tmdbId: 200, tvdbId: null, mediaType: 'tv', title: 'High Maintenance' }, s, 1, 1, { available: true });
  }
  state.media.push({
    id: 20, mediaType: 'tv', tmdbId: 200, status: 5,
    seasons: [1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n, status: 5 })),
  });
  state.series.push({
    tvdbId: 2000, tmdbId: 0, title: 'High Maintenance',
    seasons: [1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: 8 } })),
  });

  const dry = await reconcileWithArr({ dryRun: true });
  assert.deepEqual(dry.plan.remove.filter((i) => /High Maintenance/.test(i.label)), []);
  assert.deepEqual(dry.plan.add.filter((i) => /High Maintenance/.test(i.label)).length, 2);

  await reconcileWithArr({ runId: 'r6' });
  for (const s of [1, 2, 3, 4, 5, 6]) {
    assert.ok(units().find((u) => u.title === 'High Maintenance' && u.season_number === s), `season ${s} should exist`);
  }
  const hm = units().filter((u) => u.title === 'High Maintenance');
  assert.ok(hm.every((u) => u.tvdb_id === 2000 && u.ref_key === 'tv:2000'), 'ids are backfilled from Sonarr');
});

test('reconcile: a show with no usable id on either side is kept rather than guessed gone', async () => {
  credits.addUnit({ seerrId: 21, tmdbId: 210, tvdbId: null, mediaType: 'tv', title: 'Unmatched Show' }, 1, 1, 1, { available: true });
  state.media.push({ id: 21, mediaType: 'tv', tmdbId: 210, status: 5, seasons: [{ seasonNumber: 1, status: 5 }] });
  const saved = state.series;
  state.series = saved.map((s) => ({ ...s, tmdbId: 0 })); // this Sonarr reports no TMDB ids at all
  const dry = await reconcileWithArr({ dryRun: true });
  state.series = saved;
  assert.deepEqual(dry.plan.remove.filter((i) => /Unmatched Show/.test(i.label)), []);
});

test('reconcile: a show split across two Seerr records is matched by TVDB id alone', async () => {
  // Sonarr has one show with 6 seasons. Seerr holds it as two media records (seasons 1-4 and 5-6).
  for (const s of [1, 2, 3, 4]) {
    credits.addUnit({ seerrId: 30, tmdbId: 300, tvdbId: 3000, mediaType: 'tv', title: 'Split Show' }, s, 1, 1, { available: true });
  }
  state.media.push(
    { id: 30, mediaType: 'tv', tmdbId: 300, tvdbId: 3000, status: 4, seasons: [1, 2, 3, 4].map((n) => ({ seasonNumber: n, status: 5 })) },
    { id: 31, mediaType: 'tv', tmdbId: 301, tvdbId: 3000, status: 4, seasons: [5, 6].map((n) => ({ seasonNumber: n, status: 1 })) }, // Seerr status says nothing is held
  );
  state.series.push({
    tvdbId: 3000, tmdbId: 300, title: 'Split Show',
    seasons: [1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: 5 } })),
  });

  const dry = await reconcileWithArr({ dryRun: true });
  assert.deepEqual(dry.plan.remove.filter((i) => /Split Show/.test(i.label)), []);
  assert.equal(dry.plan.add.filter((i) => /Split Show/.test(i.label)).length, 2); // seasons 5 and 6, whatever Seerr's status says
  await reconcileWithArr({ runId: 'r7' });
  for (const n of [1, 2, 3, 4]) assert.equal(find(30, n).seerr_id, 30);
  for (const n of [5, 6]) assert.equal(find(31, n).available, 1);
});

test('reconcile: Radarr items Seerr has no record for are still added, with no Seerr link', async () => {
  state.movies.push({ tmdbId: 999, title: 'Direct Add', hasFile: true });
  await reconcileWithArr({ runId: 'r-direct' });
  const u = units().find((x) => x.tmdb_id === 999);
  assert.ok(u);
  assert.equal(u.seerr_id, null);
  assert.equal(u.ref_key, 'movie:999');
  assert.equal(u.current_owner_id, 1);
  assert.equal(u.available, 1);
  const again = await reconcileWithArr({ dryRun: true });
  assert.equal(again.added, 0);
});

test('reconcile: Radarr/Sonarr entries with no usable id are reported, not silently dropped', async () => {
  state.movies.push({ tmdbId: 0, title: 'No Id One', hasFile: true }, { title: 'No Id Two', hasFile: true });
  state.series.push({ tvdbId: 0, tmdbId: 0, title: 'No Id Show', seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 3 } }] });
  const before = units().length;
  const dry = await reconcileWithArr({ dryRun: true });
  state.movies = state.movies.filter((m) => m.title !== 'No Id One' && m.title !== 'No Id Two');
  state.series = state.series.filter((s) => s.title !== 'No Id Show');
  assert.deepEqual(dry.plan.noId.map((n) => n.label).sort(), ['No Id One', 'No Id Show', 'No Id Two']);
  assert.equal(dry.noId, 3);
  assert.equal(units().length, before);
});
