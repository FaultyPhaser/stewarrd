import { config } from '../config.js';
import { createArrClient } from './arr.js';

const client = createArrClient('Radarr', config.radarr);

export const configured = client.configured;

export const listMovies = () => client.call('/api/v3/movie');

/** Admin-confirmed deletion only. Never called from a scheduler. */
export async function deleteMovieByTmdbId(tmdbId) {
  const found = await client.call(`/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`);
  const movie = Array.isArray(found) ? found[0] : null;
  if (!movie) return { found: false };
  await client.call(`/api/v3/movie/${movie.id}?deleteFiles=true&addImportExclusion=false`, { method: 'DELETE' });
  return { found: true };
}
