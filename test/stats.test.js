import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
process.env.SEERR_URL = 'http://localhost:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // items are released right after requesting them
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '20';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '1';

const credits = await import('../src/services/credits.js');
const { applyFlag } = await import('../src/services/transfers.js');

test('stats count a user\'s movies and seasons, the server totals, and what is unclaimed', () => {
  assert.deepEqual(credits.getStats(2), {
    movies: { mine: 0, total: 0 },
    seasons: { mine: 0, total: 0 },
    unclaimed: { movies: 0, seasons: 0, total: 0 },
  });

  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });
  const movie = (requestId, requesterId, tmdbId) => credits.chargeForRequest({
    requestId, requesterId, unitCost: 1, media: { seerrId: tmdbId, tmdbId, tvdbId: null, mediaType: 'movie', title: `Movie ${tmdbId}` },
  });
  movie(1, 2, 100);
  movie(2, 2, 101);
  movie(3, 3, 102);
  credits.chargeForRequest({
    requestId: 4, requesterId: 2, unitCost: 1, seasons: [1, 2, 3],
    media: { seerrId: 50, tmdbId: 500, tvdbId: 5000, mediaType: 'tv', title: 'Show' },
  });

  assert.deepEqual(credits.getStats(2), {
    movies: { mine: 2, total: 3 },
    seasons: { mine: 3, total: 3 },
    unclaimed: { movies: 0, seasons: 0, total: 0 },
  });

  // Releasing moves an item out of "mine" and into "unclaimed"; the server total is unchanged.
  applyFlag(credits.findUnit('movie:100').unit_id, 2);
  applyFlag(credits.findUnit('tv:5000', 2).unit_id, 2);

  assert.deepEqual(credits.getStats(2), {
    movies: { mine: 1, total: 3 },
    seasons: { mine: 2, total: 3 },
    unclaimed: { movies: 1, seasons: 1, total: 2 },
  });
  assert.equal(credits.getStats(3).movies.mine, 1);
});
