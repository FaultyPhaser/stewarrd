import { config } from '../config.js';
import { createArrClient } from './arr.js';

const client = createArrClient('Sonarr', config.sonarr);

export const configured = client.configured;

export const listSeries = () => client.call('/api/v3/series');

async function findSeries({ tvdbId, tmdbId }) {
  if (tvdbId) {
    const found = await client.call(`/api/v3/series?tvdbId=${encodeURIComponent(tvdbId)}`);
    return Array.isArray(found) ? (found[0] ?? null) : null;
  }
  if (tmdbId) {
    const all = await client.call('/api/v3/series');
    return (all ?? []).find((s) => s.tmdbId === tmdbId) ?? null;
  }
  return null;
}

/** Admin-confirmed deletion only. Never called from a scheduler. Removes the whole series. */
export async function deleteSeries(ids) {
  const series = await findSeries(ids);
  if (!series) return { found: false };
  await client.call(`/api/v3/series/${series.id}?deleteFiles=true&addImportListExclusion=false`, { method: 'DELETE' });
  return { found: true };
}

/**
 * Admin-confirmed removal of ONE season: deletes that season's episode files, then unmonitors the
 * season so Sonarr doesn't download it again. The series entry and its other seasons are untouched.
 */
export async function deleteSeason({ tvdbId, tmdbId, seasonNumber }) {
  const series = await findSeries({ tvdbId, tmdbId });
  if (!series) return { found: false };

  const files = await client.call(`/api/v3/episodefile?seriesId=${series.id}`);
  const targets = (files ?? []).filter((f) => f.seasonNumber === seasonNumber);
  for (const file of targets) {
    await client.call(`/api/v3/episodefile/${file.id}`, { method: 'DELETE' });
  }

  const full = await client.call(`/api/v3/series/${series.id}`);
  const season = (full.seasons ?? []).find((s) => s.seasonNumber === seasonNumber);
  if (season?.monitored) {
    season.monitored = false;
    await client.call(`/api/v3/series/${series.id}`, { method: 'PUT', body: full });
  }
  return { found: true, filesDeleted: targets.length };
}
