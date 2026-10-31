import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { upsertUser } from './credits.js';
import { listUsers } from './seerr.js';

const byPlexId = db.prepare('SELECT seerr_user_id AS id, username FROM users WHERE plex_id = ?');

async function findInSeerr(plexId) {
  let users;
  try {
    users = await listUsers();
  } catch (err) {
    console.error('Plex login: could not read Seerr users:', err.message);
    return null;
  }
  const u = users.find((x) => x.plexId !== undefined && x.plexId !== null && String(x.plexId) === plexId);
  if (!u) return null;
  upsertUser({
    id: u.id,
    email: u.email ?? null,
    username: u.displayName || u.plexUsername || u.username || u.email || `user-${u.id}`,
    plexId,
  });
  return byPlexId.get(plexId) ?? null;
}

/**
 * Maps a signed-in Plex account to a stewardship user. The Plex id must belong to a user this app
 * already knows or that Seerr lists. A Plex login never creates a user out of thin air.
 */
export async function resolvePlexUser(plexUser) {
  if (plexUser?.id === undefined || plexUser?.id === null) throw new HttpError(502, 'Plex returned no user id', { expose: true });
  const plexId = String(plexUser.id);
  const row = byPlexId.get(plexId) ?? (await findInSeerr(plexId));
  if (!row) throw new HttpError(403, 'This Plex account is not a Seerr user. Ask the admin to add you in Seerr.');
  return row;
}
