import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config } from '../config.js';
import { listFlagged, unitLabel } from './credits.js';
import { runIntegrityCheck } from './integrity.js';

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** Admin summary of unclaimed items. Report only: nothing is deleted here. */
export function buildReport() {
  return {
    generatedAt: new Date().toISOString(),
    month: monthKey(),
    items: listFlagged().map((r) => ({
      unitId: r.unit_id,
      groupKey: r.ref_key,
      seerrId: r.seerr_id,
      seasonNumber: r.season_number,
      title: r.title,
      label: unitLabel(r),
      type: r.media_type,
      tmdbId: r.tmdb_id,
      tvdbId: r.tvdb_id,
      ownerId: r.current_owner_id,
      ownerName: r.owner_username ?? null,
      flaggedAt: r.flagged_at,
    })),
  };
}

function writeFile(name, payload) {
  fs.writeFileSync(path.join(config.dataDir, name), JSON.stringify(payload, null, 2));
}

export function writeLeavingSoonSnapshot() {
  const items = listFlagged();
  writeFile(`leaving-soon-${monthKey()}.json`, {
    generatedAt: new Date().toISOString(),
    movies: [...new Set(items.filter((i) => i.media_type === 'movie' && i.tmdb_id).map((i) => i.tmdb_id))],
    shows: [...new Set(items.filter((i) => i.media_type === 'tv' && i.tvdb_id).map((i) => i.tvdb_id))],
  });
}

export function writeEndOfMonthReport() {
  const report = buildReport();
  writeFile(`purge-report-${report.month}.json`, report);
  console.log(`End-of-month report ready: ${report.items.length} unclaimed item(s). Review in the admin dashboard.`);
}

export function startScheduler() {
  // Sundays 03:00: integrity check (corrects balances, logs every change).
  cron.schedule('0 3 * * 0', () => {
    runIntegrityCheck({ trigger: 'weekly' }).catch((err) => console.error('Integrity check failed:', err.message));
  });
  // 1st of the month, 00:05: snapshot the leaving-soon list.
  cron.schedule('5 0 1 * *', writeLeavingSoonSnapshot);
  // Last day of the month, 23:55: build the admin report (report only, never deletes).
  cron.schedule('55 23 28-31 * *', () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    if (tomorrow.getDate() === 1) writeEndOfMonthReport();
  });
}
