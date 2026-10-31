import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { ACT_AS_COOKIE, readCookie, sessionUserId, verify } from '../services/session.js';
import { getCurrentUser } from '../services/seerr.js';
import { upsertUser } from '../services/credits.js';

// The injected script runs on the Seerr origin, so the browser sends Seerr's own session cookie
// (never our Plex-login cookie). Seerr is asked who that is; only that one cookie is forwarded.
const SEERR_COOKIE = 'connect.sid';
const SEERR_CACHE_MS = 60_000;
const seerrSessions = new Map(); // raw cookie value -> { id, exp }

async function seerrSessionUserId(req) {
  const value = readCookie(req, SEERR_COOKIE);
  if (!value) return null;

  const hit = seerrSessions.get(value);
  if (hit && hit.exp > Date.now()) return hit.id;
  seerrSessions.delete(value);

  let me;
  try {
    me = await getCurrentUser(`${SEERR_COOKIE}=${value}`);
  } catch {
    return null; // invalid session or Seerr unreachable: not signed in
  }
  if (!Number.isInteger(me?.id)) return null;

  if (!db.prepare('SELECT 1 FROM users WHERE seerr_user_id = ?').get(me.id)) {
    upsertUser({
      id: me.id,
      email: me.email ?? null,
      username: me.displayName || me.plexUsername || me.username || me.email || null,
      plexId: me.plexId ?? null,
    });
  }
  if (seerrSessions.size > 500) seerrSessions.clear();
  seerrSessions.set(value, { id: me.id, exp: Date.now() + SEERR_CACHE_MS });
  return me.id;
}

/**
 * Authenticates with the signed Plex-login session cookie, or (for the script injected into Seerr)
 * with the caller's Seerr session. Dev / admin run use the user picker instead.
 */
export async function authenticate(req, _res, next) {
  try {
    let id;
    let actingAsBy = null; // the real admin's id while they are acting as another user
    if (config.fakeLogin) {
      // Dev / admin run only: the "dev_user" cookie picks a user instead of a real login.
      const match = /(?:^|;\s*)dev_user=(\d+)/.exec(req.headers.cookie ?? '');
      if (!match) throw new HttpError(401, 'Not logged in (dev mode: pick a user)');
      id = Number(match[1]);
    } else {
      // The Seerr session is only good enough for the injected widget; admin routes need the Plex login.
      const viaSeerr = !req.baseUrl.startsWith('/api/admin');
      const sessionId = sessionUserId(req);
      id = sessionId ?? (viaSeerr ? await seerrSessionUserId(req) : null);
      if (id === null) throw new HttpError(401, 'Not signed in');

      // Admin "act as user": only for the admin's own Plex-login session, never on /api/admin (so the admin
      // keeps their real identity for admin tools and can always stop acting), and only for a still-existing user.
      if (viaSeerr && sessionId !== null && sessionId === config.adminUserId) {
        const token = verify(readCookie(req, ACT_AS_COOKIE));
        if (token?.t === 'actas' && token.admin === sessionId && Number.isInteger(token.uid) && token.uid !== sessionId
          && db.prepare('SELECT 1 FROM users WHERE seerr_user_id = ?').get(token.uid)) {
          actingAsBy = sessionId;
          id = token.uid;
        }
      }
    }

    const row = db.prepare('SELECT username FROM users WHERE seerr_user_id = ?').get(id);
    if (!row) throw new HttpError(401, config.fakeLogin ? 'Unknown dev user' : 'Not signed in');
    req.user = { id, username: row.username, isAdmin: id === config.adminUserId, actingAs: actingAsBy !== null };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, _res, next) {
  if (!req.user?.isAdmin) return next(new HttpError(403, 'Admin only'));
  next();
}

/** Forces a CORS preflight for cross-site callers (cookie-auth CSRF defence). */
export function requireJson(req, _res, next) {
  if (req.method === 'POST' && !req.is('application/json')) {
    return next(new HttpError(415, 'Content-Type must be application/json'));
  }
  next();
}
