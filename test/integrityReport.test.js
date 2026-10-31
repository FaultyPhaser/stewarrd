import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-report-'));
process.env.SEERR_URL = 'http://127.0.0.1:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.WEBHOOK_SECRET = 's';

const { writeDryRunReport, reportPath, formatDryRun } = await import('../src/services/integrityReport.js');

const result = (runId) => ({
  runId,
  reconcile: {
    plan: {
      add: [{ label: 'Movie A', owner: 'alice', cost: 1, reason: 'open Seerr request, requester would be charged', ids: { seerrId: 5, tmdbId: 500, tvdbId: null } }],
      remove: [{ label: 'Show B - Season 2', owner: 'bob', reason: 'series no longer in Sonarr', ids: { seerrId: 6, tmdbId: 600, tvdbId: 6000 }, arr: null }],
      update: [],
      noId: [{ label: 'Odd Movie', type: 'movie', reason: 'Radarr entry has no TMDB id' }],
      backfill: [{ label: 'Show C - Season 1', owner: 'dan', reason: 'matched to Sonarr "Show C"; stored ids tmdb 7, tvdb - -> tmdb 7, tvdb 7000', ids: { seerrId: 8, tmdbId: 7, tvdbId: 7000 } }],
    },
    blocked: [],
  },
  seerr: { action: 'dry_run', removed: [7], details: [{ id: 7, mediaType: 'tv', tmdbId: 55, requester: 'carol', seasons: [1, 2] }] },
});

test('the dry-run report lists every item with its owner and reason', () => {
  const text = formatDryRun(result('r1'));
  assert.match(text, /DRY RUN/);
  assert.match(text, /Movie A \| owner: alice \| open Seerr request.*\(1 credit/);
  assert.match(text, /Movie A .*ids: seerr 5, tmdb 500, tvdb -/);
  assert.match(text, /Show B - Season 2 \| owner: bob \| series no longer in Sonarr \| ids: seerr 6, tmdb 600, tvdb 6000 \| Radarr\/Sonarr match: none/);
  assert.match(text, /request 7 \| tv tmdb:55 \| requester: carol \| seasons: 1, 2/);
  assert.match(text, /Odd Movie \| movie \| Radarr entry has no TMDB id/);
  assert.match(text, /Show C - Season 1 \| owner: dan \| matched to Sonarr "Show C".*tvdb 7000/);
});

test('the report is written under DATA_DIR, only the newest 20 are kept, and only its own names resolve', async () => {
  const names = [];
  for (let i = 0; i < 23; i += 1) names.push(writeDryRunReport(result(`2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z-ab`)));
  const dir = path.join(process.env.DATA_DIR, 'integrity-reports');
  assert.equal(fs.readdirSync(dir).length, 20);
  assert.ok(fs.existsSync(reportPath(names.at(-1))));
  assert.equal(fs.existsSync(path.join(dir, names[0])), false);

  assert.equal(reportPath('../stewarrd.db'), null);
  assert.equal(reportPath('..%2Fsecrets.txt'), null);
  assert.equal(reportPath('integrity-dryrun-../x.txt'), null);
});
