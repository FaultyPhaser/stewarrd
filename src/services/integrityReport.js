import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DIR = 'integrity-reports';
const KEEP = 20;

/** Only names this module produces are ever served, so a request can't reach any other file. */
export const REPORT_NAME = /^integrity-dryrun-[A-Za-z0-9._-]+\.txt$/;

export const reportPath = (name) => (REPORT_NAME.test(name) ? path.join(config.dataDir, DIR, name) : null);

function section(lines, title, items, fmt) {
  lines.push('', `${title} (${items.length})`);
  if (!items.length) lines.push('  none');
  for (const i of items) lines.push(`  - ${fmt(i)}`);
}

const idText = (ids) => (ids ? ` | ids: seerr ${ids.seerrId ?? '-'}, tmdb ${ids.tmdbId ?? '-'}, tvdb ${ids.tvdbId ?? '-'}` : '');
const matchText = (m) => (m ? ` | Radarr/Sonarr match: "${m.title}" tmdb ${m.tmdbId ?? '-'}, tvdb ${m.tvdbId ?? '-'}` : ' | Radarr/Sonarr match: none');

/** Plain-text detail of a dry run. Nothing in the database or in any other service was changed. */
export function formatDryRun(result) {
  const { reconcile: rc, seerr, runId } = result;
  const lines = [
    'Stewarrd integrity check: DRY RUN (nothing was changed)',
    `Run: ${runId}`,
    `Created: ${new Date().toISOString()}`,
  ];
  section(lines, 'Ownership that would be re-priced at the current costs', result.pricing?.fixes ?? [], (f) => `${f.label} | user: ${f.username ?? f.userId} | net paid ${f.before} -> ${f.after} (${f.delta > 0 ? `charge ${f.delta}` : `refund ${-f.delta}`})`);
  if (rc.skipped) {
    lines.push('', `Radarr/Sonarr/Seerr step skipped: ${rc.skipped}`);
  } else {
    section(lines, 'Items that would be added', rc.plan?.add ?? [], (i) => `${i.label} | owner: ${i.owner} | ${i.reason}${i.cost > 0 ? ` (${i.cost} credit(s))` : ''}${idText(i.ids)}`);
    section(lines, 'Items that would be removed', rc.plan?.remove ?? [], (i) => `${i.label} | owner: ${i.owner} | ${i.reason}${idText(i.ids)}${matchText(i.arr)}`);
    section(lines, 'Download states that would be updated', rc.plan?.update ?? [], (i) => `${i.label} | owner: ${i.owner} | ${i.reason}${idText(i.ids)}`);
    section(lines, 'Removals blocked by safeguards', rc.blocked ?? [], (b) => `${b.type}: ${b.count} unit(s): ${b.reason}`);
    section(lines, 'In Radarr/Sonarr but with no TMDB/TVDB id (cannot be tracked)', rc.plan?.noId ?? [], (i) => `${i.label} | ${i.type} | ${i.reason}`);
    section(lines, 'Stored ids that would be filled in from Radarr/Sonarr', rc.plan?.backfill ?? [], (i) => `${i.label} | owner: ${i.owner} | ${i.reason}${idText(i.ids)}`);
  }
  const filled = seerr.details ?? [];
  if (seerr.action === 'disabled') lines.push('', 'Filled Seerr requests: cleanup is disabled (SEERR_SYNC is off)');
  else if (seerr.action === 'skipped') lines.push('', 'Filled Seerr requests: not checked because the reconcile was skipped');
  else if (seerr.action === 'error') lines.push('', `Filled Seerr requests: could not be read (${seerr.message})`);
  else {
    section(lines, 'Filled Seerr requests that would be deleted', filled, (r) => `request ${r.id} | ${r.mediaType ?? '?'} tmdb:${r.tmdbId ?? '?'} | requester: ${r.requester}${r.seasons.length ? ` | seasons: ${r.seasons.join(', ')}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the report under DATA_DIR, keeps the newest few, and returns the file name (never a path). */
export function writeDryRunReport(result) {
  const dir = path.join(config.dataDir, DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = `integrity-dryrun-${result.runId.replace(/[^A-Za-z0-9._-]/g, '-')}.txt`;
  fs.writeFileSync(path.join(dir, name), formatDryRun(result));
  const old = fs.readdirSync(dir).filter((f) => REPORT_NAME.test(f)).sort().slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return name;
}
