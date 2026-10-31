import { config } from '../config.js';
import { requestJson } from './http.js';

const base = `${config.seerr.url}/api/v1`;
const apiHeaders = { 'X-Api-Key': config.seerr.apiKey };

const call = (path, opts = {}) =>
  requestJson(`${base}${path}`, { service: 'Seerr', ...opts, headers: apiHeaders });

/** Resolve the calling user by forwarding their own Seerr session cookie. */
export const getCurrentUser = (cookie) =>
  requestJson(`${base}/auth/me`, { service: 'Seerr', headers: { Cookie: cookie } });

export const getRequest = (requestId) => call(`/request/${requestId}`);
export const approveRequest = (requestId) => call(`/request/${requestId}/approve`, { method: 'POST' });
export const declineRequest = (requestId) => call(`/request/${requestId}/decline`, { method: 'POST' });

/** Seerr's record of a title, including every request made for it (null if Seerr doesn't track it). */
export async function getMediaInfo(type, tmdbId) {
  try {
    const data = await call(`/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`);
    return data?.mediaInfo ?? null;
  } catch (err) {
    if (err.upstreamStatus === 404) return null;
    throw err;
  }
}

/** Removes a request from Seerr (and from the requester's list). Needs the API key's MANAGE_REQUESTS. */
export const deleteRequest = (requestId) => call(`/request/${requestId}`, { method: 'DELETE' });

/** Creates a request on behalf of body.userId. */
export const createRequest = (body) => call('/request', { method: 'POST', body });

export async function getTitle(type, tmdbId) {
  try {
    const data = await call(`/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`);
    return data?.title || data?.name || `tmdb:${tmdbId}`;
  } catch {
    return `tmdb:${tmdbId}`;
  }
}

/** Pages through every Seerr user (read-only). */
export async function listUsers() {
  const take = 100;
  const results = [];
  for (let skip = 0; ; skip += take) {
    const page = await call(`/user?take=${take}&skip=${skip}`);
    const items = page?.results ?? [];
    results.push(...items);
    if (items.length < take) break;
  }
  return results;
}

/** Pages through every request in Seerr, whatever its status. */
export async function listAllRequests() {
  const take = 100;
  const results = [];
  for (let skip = 0; ; skip += take) {
    const page = await call(`/request?filter=all&sort=added&take=${take}&skip=${skip}`);
    const items = page?.results ?? [];
    results.push(...items);
    if (items.length < take) break;
  }
  return results;
}

/** Pages through every media record Seerr knows about. */
export async function listAllMedia() {
  const take = 200;
  const results = [];
  for (let skip = 0; ; skip += take) {
    const page = await call(`/media?take=${take}&skip=${skip}&filter=all`);
    const items = page?.results ?? [];
    results.push(...items);
    if (items.length < take) break;
  }
  return results;
}
