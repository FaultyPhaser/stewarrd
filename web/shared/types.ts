/** Shapes returned by the sidecar API (see src/routes/api.js and src/routes/admin.js). */

export interface Me {
  userId: number;
  username?: string | null;
  credits: number | null;
  allowance: number | null;
  costs: { movie: number; tv: number };
  isAdmin: boolean;
  actingAs: boolean;
}

/** Counts for the side bar (GET /user/stats). Units are movies and single seasons. */
export interface UserStats {
  movies: { mine: number; total: number };
  seasons: { mine: number; total: number };
  unclaimed: { movies: number; seasons: number; total: number };
}

export type MediaType = 'movie' | 'tv';

/** One tracked unit: a movie, or a single season of a show. */
export interface Item {
  unitId: number;
  groupKey: string;
  seerrId?: number | null;
  tmdbId?: number | null;
  type: MediaType;
  title: string;
  label: string;
  seasonNumber: number | null;
  status: 'ACTIVE' | 'FLAGGED_FOR_REMOVAL' | string;
  /** False while the files are not downloaded yet. */
  available?: boolean;
  ownerId?: number;
  ownerName?: string | null;
  flaggedAt?: string | null;
  /** Days left of the minimum stewardship time (owner's own items only; 0 = can be released). */
  remainingDays?: number;
}

export interface SeerrOutcome {
  action?: string;
  message?: string;
}

export interface BulkResult {
  ok: boolean;
  label: string;
  error?: string;
  seerr?: SeerrOutcome;
}

export interface ActivityEvent {
  type: MediaType;
  tmdbId: number;
  title?: string;
  action: string;
  cost: number;
  balance: number;
  reason?: string;
  at: string;
}
