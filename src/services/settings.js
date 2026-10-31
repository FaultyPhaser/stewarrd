import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

// Small key/value store for settings an admin can change at runtime (and other one-off state flags).
db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)');
export const stateGet = db.prepare('SELECT value FROM app_state WHERE key = ?');
export const stateSet = db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');

const DAY_MS = 86_400_000;
const KEY_DAYS = 'min_stewardship_days';
const KEY_CLAIMS = 'stewardship_applies_to_claims';
export const MAX_STEWARDSHIP_DAYS = 3650;

const defaultDays = () => Math.max(0, config.minStewardshipDays);

/** Days an owner must hold an item before releasing it. 0 = no minimum. */
export function getMinStewardshipDays() {
  const raw = stateGet.get(KEY_DAYS)?.value;
  if (raw === undefined) return defaultDays();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : defaultDays();
}

/** Whether claiming (saving) a released item starts the minimum stewardship period. On by default. */
export function getStewardshipOnClaims() {
  const raw = stateGet.get(KEY_CLAIMS)?.value;
  return raw === undefined ? true : raw !== '0';
}

export const MAX_CREDITS = 100_000;

// Credit settings: the env vars (DEFAULT_CREDITS, CREDIT_COST_MOVIE, CREDIT_COST_TV_SEASON) are the defaults,
// an admin value saved from the dashboard overrides them.
const CREDIT_KEYS = {
  defaultCredits: { key: 'default_credits', fallback: () => config.defaultCredits },
  costMovie: { key: 'credit_cost_movie', fallback: () => config.costs.movie },
  costTvSeason: { key: 'credit_cost_tv_season', fallback: () => config.costs.tvSeason },
};

function creditSetting(name) {
  const { key, fallback } = CREDIT_KEYS[name];
  const raw = stateGet.get(key)?.value;
  if (raw === undefined) return fallback();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback();
}

/** Total credits a user starts with (before any per-user override). */
export const getDefaultCredits = () => creditSetting('defaultCredits');

/** Credits one request unit costs: a movie, or ONE season of a show. */
export const getCosts = () => ({ movie: creditSetting('costMovie'), tvSeason: creditSetting('costTvSeason') });

export function getSettings() {
  return {
    minStewardshipDays: getMinStewardshipDays(),
    applyToClaims: getStewardshipOnClaims(),
    defaultMinStewardshipDays: defaultDays(),
    defaultCredits: getDefaultCredits(),
    costMovie: getCosts().movie,
    costTvSeason: getCosts().tvSeason,
    envDefaults: {
      defaultCredits: config.defaultCredits,
      costMovie: config.costs.movie,
      costTvSeason: config.costs.tvSeason,
    },
  };
}

export function updateSettings({ minStewardshipDays, applyToClaims, defaultCredits, costMovie, costTvSeason } = {}) {
  const credits = { defaultCredits, costMovie, costTvSeason };
  for (const [name, value] of Object.entries(credits)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > MAX_CREDITS)) {
      throw new HttpError(400, `${name} must be a whole number from 0 to ${MAX_CREDITS}`);
    }
  }
  if (minStewardshipDays !== undefined) {
    if (!Number.isInteger(minStewardshipDays) || minStewardshipDays < 0 || minStewardshipDays > MAX_STEWARDSHIP_DAYS) {
      throw new HttpError(400, `minStewardshipDays must be a whole number from 0 to ${MAX_STEWARDSHIP_DAYS}`);
    }
  }
  if (applyToClaims !== undefined && typeof applyToClaims !== 'boolean') {
    throw new HttpError(400, 'applyToClaims must be true or false');
  }
  if (minStewardshipDays !== undefined) stateSet.run(KEY_DAYS, String(minStewardshipDays));
  if (applyToClaims !== undefined) stateSet.run(KEY_CLAIMS, applyToClaims ? '1' : '0');
  for (const [name, value] of Object.entries(credits)) {
    if (value !== undefined) stateSet.run(CREDIT_KEYS[name].key, String(value));
  }
  return getSettings();
}

/** Whole days left before the unit's owner may release it (0 = free to release now). Uses the unit's `held_since`. */
export function remainingHoldDays(row, now = Date.now()) {
  const days = getMinStewardshipDays();
  if (!days || !row?.held_since) return 0;
  const since = Date.parse(`${String(row.held_since).replace(' ', 'T')}Z`); // SQLite CURRENT_TIMESTAMP is UTC
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.ceil(days - (now - since) / DAY_MS));
}
