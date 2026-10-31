import type { MediaType } from '../shared/types';

/** Seerr's page for a title (seasons have no page of their own, so they use the show's). `null` without a usable TMDB id. */
export function seerrPath(type: MediaType | string, tmdbId: number | null | undefined): string | null {
  if (type !== 'movie' && type !== 'tv') return null;
  return Number.isInteger(tmdbId) && (tmdbId as number) > 0 ? `/${type}/${tmdbId}` : null;
}
