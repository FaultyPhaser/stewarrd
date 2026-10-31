import 'dotenv/config';
import path from 'node:path';

const str = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;

const int = (key, fallback) => {
  const raw = (process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
};

const url = (key) => str(key).replace(/\/+$/, '');

const devMode = int('DEV_MODE', 0) > 0;
// Admin run mode: fake-login user picker like dev mode, but REAL Seerr (reads and request
// create/delete). Radarr/Sonarr stay disabled so nothing is deleted from disk.
const adminRun = int('ADMIN_RUN', 0) > 0;
if (devMode && adminRun) {
  throw new Error('DEV_MODE and ADMIN_RUN are mutually exclusive');
}
if ((devMode || adminRun) && process.env.NODE_ENV === 'production') {
  throw new Error('DEV_MODE / ADMIN_RUN must not be enabled when NODE_ENV=production');
}

const missing = devMode
  ? []
  : ['SEERR_URL', 'SEERR_API_KEY', 'ADMIN_USER_ID', 'WEBHOOK_SECRET'].filter((k) => !str(k));
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

// In dev mode the external services are always disabled, even if the .env has real
// keys, so simulations can never reach (or delete anything from) real Radarr/Sonarr.
// Admin run mode disables them too, so nothing is deleted from disk.
const service = (prefix) => Object.freeze(
  devMode || adminRun
    ? { url: '', apiKey: '' }
    : { url: url(`${prefix}_URL`), apiKey: str(`${prefix}_API_KEY`) },
);

export const config = Object.freeze({
  devMode,
  adminRun,
  fakeLogin: devMode || adminRun, // the "acting as" user picker replaces Seerr login
  // Keep Seerr requests in step with ownership (claim creates a request, an admin purge removes the requests of a deleted item; release leaves Seerr alone).
  // On in admin run mode; in normal mode it must be switched on explicitly with SEERR_SYNC=1.
  seerrSync: !devMode && (adminRun || int('SEERR_SYNC', 0) > 0),
  // Optional allow-list of Seerr user ids whose requests may be touched (empty = everyone).
  seerrSyncUsers: new Set(
    str('SEERR_SYNC_USER_IDS').split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isInteger),
  ),
  port: int('PORT', 3000),
  // Admin run lets anyone who can reach the port act as any user, so it stays on loopback.
  host: adminRun && !int('ADMIN_RUN_ALLOW_REMOTE', 0) ? '127.0.0.1' : str('HOST', '0.0.0.0'),
  trustProxy: int('TRUST_PROXY', 0) > 0,
  // Plex login session. Without SESSION_SECRET a random one is generated once and kept in the data dir.
  sessionSecret: str('SESSION_SECRET'),
  sessionDays: int('SESSION_DAYS', 14),
  dataDir: path.resolve(str('DATA_DIR', 'data')),
  adminUserId: int('ADMIN_USER_ID', 1),
  webhookSecret: str('WEBHOOK_SECRET'),
  seerr: Object.freeze({ url: url('SEERR_URL'), apiKey: str('SEERR_API_KEY') }),
  radarr: service('RADARR'),
  sonarr: service('SONARR'),
  defaultCredits: int('DEFAULT_CREDITS', 3),
  costs: Object.freeze({
    movie: int('CREDIT_COST_MOVIE', 1),
    tvSeason: int('CREDIT_COST_TV_SEASON', 2),
  }),
  // Default minimum days an owner must hold an item before releasing it. Admins can change it at runtime.
  minStewardshipDays: int('MIN_STEWARDSHIP_DAYS', 30),
});
