import crypto from 'node:crypto';
import { requestJson } from './http.js';
import { persisted } from './secrets.js';

// No app registration is needed: Plex's PIN login only wants a client identifier we make up.
const API = (process.env.PLEX_API_URL || 'https://plex.tv').replace(/\/+$/, '');
const PRODUCT = 'Stewarrd';

export const clientId = () => persisted('plex-client-id', () => crypto.randomUUID());

const headers = (token) => ({
  'X-Plex-Client-Identifier': clientId(),
  'X-Plex-Product': PRODUCT,
  'X-Plex-Version': '1.0',
  ...(token ? { 'X-Plex-Token': token } : {}),
});

const call = (path, opts = {}) =>
  requestJson(`${API}${path}`, { service: 'Plex', ...opts, headers: headers(opts.token) });

/** Starts a login. Returns { id, code }. */
export const createPin = () => call('/api/v2/pins?strong=true', { method: 'POST' });

/** The Plex page the user signs in on. Plex sends the browser back to forwardUrl afterwards. */
export function buildAuthUrl(code, forwardUrl) {
  const q = [
    `clientID=${encodeURIComponent(clientId())}`,
    `code=${encodeURIComponent(code)}`,
    `forwardUrl=${encodeURIComponent(forwardUrl)}`,
    `context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`,
  ].join('&');
  return `https://app.plex.tv/auth#?${q}`;
}

/** The Plex auth token once the user has signed in, otherwise null. */
export async function checkPin(id, code) {
  const data = await call(`/api/v2/pins/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`);
  return data?.authToken || null;
}

/** Who owns this token. The token is used for this one call and never stored. */
export const getPlexUser = (token) => call('/api/v2/user', { token });
